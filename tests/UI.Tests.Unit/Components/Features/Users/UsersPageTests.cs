// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     UsersPageTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using System.Text.RegularExpressions;

using AngleSharp.Dom;

using Bunit.TestDoubles;

using Domain.Abstractions;

using FluentValidation;

using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Primitives;
using Microsoft.Extensions.Time.Testing;

using UI.Components.Features.Users;
using UI.ManagementApi;

namespace UI.Tests.Unit.Components.Features.Users;

// The real handler and validator run against a substituted IManagementApi, a bUnit navigation manager and a
// FakeTimeProvider (docs/plans/user-role-management.md, "Testing"). The page's markup contract these tests rely on:
// the search box is the only input[placeholder]; typing is an oninput and Enter an onkeydown; the User rows are the
// <li> children of the page's only <ul>; "‹ Prev" and "Next ›" are <button>s; the tab switch is two <a>s; and the page
// writes its URL by calling the module's replaceUrl(url) function.
public class UsersPageTests : BunitContext
{
	private const string ModulePath = "./Components/Features/Users/UsersPage.razor.js";
	private const string SearchBox = "input[placeholder='Search name or email']";
	private const string ManagementApiMessage = "couldn't reach Auth0's Management API";

	private readonly IManagementApi _api = Substitute.For<IManagementApi>();
	private readonly FakeTimeProvider _time = new();
	private readonly BunitJSModuleInterop _module;
	private readonly BunitPersistentComponentState _persisted;

	public UsersPageTests()
	{
		Services.AddSingleton(_api);
		Services.AddSingleton<TimeProvider>(_time);
		Services.AddSingleton<IValidator<SearchUsersQuery>, SearchUsersQueryValidator>();
		Services.AddSingleton<SearchUsersHandler>();
		_persisted = AddBunitPersistentComponentState();
		_module = JSInterop.SetupModule(ModulePath);
		_module.Mode = JSRuntimeMode.Loose;

		ReturnPage(People(3), 3);
		_api.ListRolesAsync(Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok<IReadOnlyList<RoleSummary>>([new RoleSummary("role-admin", "Admin", null)])));
		_api.ListRoleMembersAsync("role-admin", Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new RoleMembers([], false))));
		SetRendererInfo(new RendererInfo("Server", true));
	}

	private BunitNavigationManager Navigation => (BunitNavigationManager)Services.GetRequiredService<NavigationManager>();

	[Fact]
	public void Render_Admin_ShowsEachUsersNameAndEmail()
	{
		// Arrange
		ReturnPage([new UserSummary("auth0|1", "Jane Doe", "jane@example.com", null, null)], 1);

		// Act
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Assert
		IElement row = Rows(cut).Should().ContainSingle().Subject;
		row.TextContent.Should().Contain("Jane Doe").And.Contain("jane@example.com");
	}

	[Fact]
	public void Render_UserWithoutPicture_ShowsTheirInitials()
	{
		// Arrange
		ReturnPage([new UserSummary("auth0|1", "Jane Doe", "jane@example.com", null, null)], 1);

		// Act
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Assert
		IElement row = Rows(cut).Single();
		row.QuerySelector("img").Should().BeNull();
		row.TextContent.Should().Contain("JD");
	}

	[Fact]
	public void Render_UserWithPicture_ShowsThePictureInsteadOfInitials()
	{
		// Arrange
		ReturnPage([new UserSummary("auth0|1", "Jane Doe", "jane@example.com", "https://cdn.example.com/jane.png", null)], 1);

		// Act
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Assert
		IElement row = Rows(cut).Single();
		row.QuerySelector("img")!.GetAttribute("src").Should().Be("https://cdn.example.com/jane.png");
		row.TextContent.Should().NotContain("JD");
	}

	[Fact]
	public void Render_UsersWhoHoldAdmin_ShowAnAdminBadgeAndTheOthersDoNot()
	{
		// Arrange
		UserSummary[] people = People(3);
		ReturnPage(people, 3);
		_api.ListRoleMembersAsync("role-admin", Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new RoleMembers([people[1]], false))));

		// Act
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Assert
		IReadOnlyList<IElement> rows = Rows(cut);
		rows.Should().HaveCount(3);
		rows[0].TextContent.Should().NotContain("Admin");
		rows[1].TextContent.Should().Contain("Admin");
		rows[2].TextContent.Should().NotContain("Admin");
	}

	[Fact]
	public void Render_ThreePeople_AsksForAdminMembersOnceNotPerUser()
	{
		// Arrange

		// Act
		RenderPage();

		// Assert
		_api.Received(1).ListRolesAsync(Arg.Any<CancellationToken>());
		_api.Received(1).ListRoleMembersAsync("role-admin", Arg.Any<CancellationToken>());
		_api.DidNotReceiveWithAnyArgs().UserHoldsRoleAsync(default!, default!, Arg.Any<CancellationToken>());
		_api.DidNotReceiveWithAnyArgs().GetUserAsync(default!, Arg.Any<CancellationToken>());
	}

	[Fact]
	public void Render_AfterThePrerenderPersistedTheList_StartsFromItWithoutSearchingAgain()
	{
		// Arrange
		UserSummary[] people = People(3);
		ReturnPage(people, 3);
		_api.ListRoleMembersAsync("role-admin", Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new RoleMembers([people[1]], false))));
		IRenderedComponent<UsersPage> prerendered = RenderPage();
		_persisted.TriggerOnPersisting();
		prerendered.Dispose();
		_api.ClearReceivedCalls();

		// Act
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Assert
		IReadOnlyList<IElement> rows = Rows(cut);
		rows.Should().HaveCount(3);
		rows[1].TextContent.Should().Contain("Admin");
		_api.DidNotReceiveWithAnyArgs().SearchUsersAsync(default!, Arg.Any<CancellationToken>());
		_api.DidNotReceiveWithAnyArgs().ListRolesAsync(Arg.Any<CancellationToken>());
		_api.DidNotReceiveWithAnyArgs().ListRoleMembersAsync(default!, Arg.Any<CancellationToken>());
	}

	[Fact]
	public void Render_PrerenderThenCircuitStart_SearchesOncePerPageLoad()
	{
		// Arrange
		IRenderedComponent<UsersPage> prerendered = RenderPage();
		_persisted.TriggerOnPersisting();
		prerendered.Dispose();

		// Act
		RenderPage();

		// Assert
		_api.Received(1).SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>());
	}

	[Fact]
	public void Render_NothingPersisted_Searches()
	{
		// Arrange

		// Act
		RenderPage();

		// Assert
		_api.Received(1).SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>());
	}

	[Fact]
	public void Render_AdminMembersTruncated_NotesThatTheAdminBadgesMayBeIncomplete()
	{
		// Arrange
		_api.ListRoleMembersAsync("role-admin", Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new RoleMembers([], true))));

		// Act
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Assert
		TextOf(cut).Should().Contain("Admin badges may be incomplete");
	}

	[Fact]
	public void Render_AdminMembersComplete_ShowsNoIncompleteBadgesNote()
	{
		// Arrange

		// Act
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Assert
		TextOf(cut).Should().NotContain("Admin badges may be incomplete");
	}

	[Fact]
	public void Render_Admin_ShowsTheSearchBoxWithItsPlaceholder()
	{
		// Arrange

		// Act
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Assert
		cut.Find(SearchBox).Should().NotBeNull();
	}

	[Fact]
	public void Render_NoUserPicked_PromptsTheAdminToPickAUser()
	{
		// Arrange

		// Act
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Assert
		TextOf(cut).Should().Contain("Pick a User");
	}

	[Fact]
	public void Render_Admin_ShowsTheUsersAndRolesTabsAsOrdinaryNavigationLinks()
	{
		// Arrange

		// Act
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Assert
		IElement users = cut.FindAll("a").Single(link => link.TextContent.Trim() == "Users");
		IElement roles = cut.FindAll("a").Single(link => link.TextContent.Trim() == "Roles");
		Navigation.ToAbsoluteUri(users.GetAttribute("href")!).AbsolutePath.Should().Be("/admin/users");
		Navigation.ToAbsoluteUri(roles.GetAttribute("href")!).AbsolutePath.Should().Be("/admin/roles");
		users.GetAttribute("data-enhance-nav").Should().Be("false");
		roles.GetAttribute("data-enhance-nav").Should().Be("false");
	}

	[Fact]
	public void Render_FirstPageOfSixty_ShowsPrevPageXOfYWithTheTotalAndNext()
	{
		// Arrange
		ReturnPage(People(25), 60);

		// Act
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Assert
		Rows(cut).Should().HaveCount(25);
		TextOf(cut).Should().Contain("Page 1 of 3 · 60 Users");
		ButtonWithText(cut, "Prev").Should().NotBeNull();
		ButtonWithText(cut, "Next").HasAttribute("disabled").Should().BeFalse();
	}

	[Fact]
	public void Render_LastReachablePage_DisablesNext()
	{
		// Arrange
		Open("?page=3");
		ReturnPage(People(10), 60);

		// Act
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Assert
		TextOf(cut).Should().Contain("Page 3 of 3 · 60 Users");
		ButtonWithText(cut, "Next").HasAttribute("disabled").Should().BeTrue();
	}

	[Fact]
	public void Render_PageBeyondTheLastPage_ShowsTheLastReachablePage()
	{
		// Arrange
		Open("?page=9");
		_api.SearchUsersAsync(Arg.Is<UserSearch>(search => search.Page == 9), Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new UserPage([], 60))));
		_api.SearchUsersAsync(Arg.Is<UserSearch>(search => search.Page == 3), Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new UserPage(People(10), 60))));

		// Act
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Assert
		TextOf(cut).Should().Contain("Page 3 of 3 · 60 Users");
		Rows(cut).Should().HaveCount(10);
	}

	[Theory]
	[InlineData("0")]
	[InlineData("-4")]
	[InlineData("abc")]
	[InlineData("")]
	[InlineData("2.5")]
	public void Render_PageBelowOneOrNotANumber_ShowsPageOne(string page)
	{
		// Arrange
		Open($"?page={page}");
		ReturnPage(People(25), 60);

		// Act
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Assert
		SearchesSent().Should().OnlyContain(search => search.Page == 1);
		TextOf(cut).Should().Contain("Page 1 of 3 · 60 Users");
	}

	[Fact]
	public void Render_SearchWithNoMatches_ShowsPageOneOfOneZeroUsersAndNoUsersMatch()
	{
		// Arrange
		ReturnPage([], 0);

		// Act
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Assert
		string text = TextOf(cut);
		text.Should().Contain("Page 1 of 1 · 0 Users").And.Contain("No Users match.");
		Rows(cut).Should().BeEmpty();
	}

	[Fact]
	public void Render_TotalOverOneThousand_ShowsTheCapNoteAndFortyPages()
	{
		// Arrange
		ReturnPage(People(25), 1500);

		// Act
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Assert
		string text = TextOf(cut);
		text.Should().MatchRegex(@"Auth0 shows only the first 1,000 of 1,?500 matches\. Narrow the search\.");
		text.Should().MatchRegex(@"Page 1 of 40 · 1,?500 Users");
	}

	[Fact]
	public void Render_TotalOfOneThousand_ShowsNoCapNote()
	{
		// Arrange
		ReturnPage(People(25), 1000);

		// Act
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Assert
		TextOf(cut).Should().NotContain("Auth0 shows only the first");
	}

	[Fact]
	public void Render_UrlHasQueryPageAndUser_ReadsThemOnce()
	{
		// Arrange
		Open("?q=jane&page=2&user=auth0%7Cuser-2");
		ReturnPage(People(25), 60);

		// Act
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Assert
		SearchesSent().Should().ContainSingle().Which.Should()
			.Be(new UserSearch(UserSearchQueryBuilder.Build("jane"), 2, 25));
		cut.Find(SearchBox).GetAttribute("value").Should().Be("jane");
	}

	[Fact]
	public void Render_UrlUnchanged_DoesNotWriteTheUrlBack()
	{
		// Arrange
		Open("?q=jane&page=2&user=auth0%7Cuser-2");
		ReturnPage(People(25), 60);

		// Act
		RenderPage();

		// Assert
		_module.Invocations["replaceUrl"].Should().BeEmpty();
	}

	[Fact]
	public void Type_ThenWaitsLessThanFourHundredMilliseconds_DoesNotSearchYet()
	{
		// Arrange
		IRenderedComponent<UsersPage> cut = RenderPage();
		_api.ClearReceivedCalls();

		// Act
		cut.Find(SearchBox).Input("jane");
		_time.Advance(TimeSpan.FromMilliseconds(399));

		// Assert
		SearchesSent().Should().BeEmpty();
	}

	[Fact]
	public void Type_ThenWaitsFourHundredMilliseconds_SearchesOnce()
	{
		// Arrange
		IRenderedComponent<UsersPage> cut = RenderPage();
		_api.ClearReceivedCalls();

		// Act
		cut.Find(SearchBox).Input("jane");
		_time.Advance(TimeSpan.FromMilliseconds(400));

		// Assert
		cut.WaitForAssertion(() => SearchesSent().Should().ContainSingle()
			.Which.Should().Be(new UserSearch(UserSearchQueryBuilder.Build("jane"), 1, 25)));
	}

	[Fact]
	public void Type_AgainBeforeTheDebounceEnds_RestartsTheWaitAndSearchesOnlyTheLastText()
	{
		// Arrange
		IRenderedComponent<UsersPage> cut = RenderPage();
		_api.ClearReceivedCalls();

		// Act
		cut.Find(SearchBox).Input("ja");
		_time.Advance(TimeSpan.FromMilliseconds(300));
		cut.Find(SearchBox).Input("jane");
		_time.Advance(TimeSpan.FromMilliseconds(300));
		SearchesSent().Should().BeEmpty();
		_time.Advance(TimeSpan.FromMilliseconds(100));

		// Assert
		cut.WaitForAssertion(() => SearchesSent().Should().ContainSingle()
			.Which.Query.Should().Be(UserSearchQueryBuilder.Build("jane")));
	}

	[Fact]
	public void PressEnter_AfterTyping_SearchesAtOnceWithoutWaitingForTheDebounce()
	{
		// Arrange
		IRenderedComponent<UsersPage> cut = RenderPage();
		_api.ClearReceivedCalls();
		cut.Find(SearchBox).Input("jane");

		// Act
		cut.Find(SearchBox).KeyDown(new KeyboardEventArgs { Key = "Enter" });

		// Assert
		cut.WaitForAssertion(() => SearchesSent().Should().ContainSingle()
			.Which.Query.Should().Be(UserSearchQueryBuilder.Build("jane")));
	}

	[Fact]
	public void PressEnter_ThenTheDebounceElapses_DoesNotSearchASecondTime()
	{
		// Arrange
		IRenderedComponent<UsersPage> cut = RenderPage();
		_api.ClearReceivedCalls();
		cut.Find(SearchBox).Input("jane");
		cut.Find(SearchBox).KeyDown(new KeyboardEventArgs { Key = "Enter" });
		cut.WaitForAssertion(() => SearchesSent().Should().HaveCount(1));

		// Act
		_time.Advance(TimeSpan.FromMilliseconds(400));

		// Assert
		SearchesSent().Should().HaveCount(1);
	}

	[Fact]
	public void Search_NewerSearchStarts_CancelsTheOneInFlight()
	{
		// Arrange
		IRenderedComponent<UsersPage> cut = RenderPage();
		_api.ClearReceivedCalls();
		List<CancellationToken> tokens = [];
		TaskCompletionSource<Result<UserPage>> neverFinishes = new();
		int calls = 0;
		_api.SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>()).Returns(call =>
		{
			tokens.Add(call.Arg<CancellationToken>());

			return calls++ == 0 ? neverFinishes.Task : Task.FromResult(Result.Ok(new UserPage(People(1), 1)));
		});
		cut.Find(SearchBox).Input("jane");
		cut.Find(SearchBox).KeyDown(new KeyboardEventArgs { Key = "Enter" });
		cut.WaitForAssertion(() => tokens.Should().HaveCount(1));

		// Act
		cut.Find(SearchBox).Input("janet");
		cut.Find(SearchBox).KeyDown(new KeyboardEventArgs { Key = "Enter" });

		// Assert
		cut.WaitForAssertion(() => tokens.Should().HaveCount(2));
		tokens[0].IsCancellationRequested.Should().BeTrue();
		tokens[1].IsCancellationRequested.Should().BeFalse();
	}

	[Fact]
	public void Search_OlderSearchFinishesLate_DoesNotReplaceTheNewerResults()
	{
		// Arrange
		IRenderedComponent<UsersPage> cut = RenderPage();
		TaskCompletionSource<Result<UserPage>> older = new();
		int calls = 0;
		_api.SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>()).Returns(_ =>
			calls++ == 0
				? older.Task
				: Task.FromResult(Result.Ok(new UserPage([new UserSummary("auth0|new", "Fresh Result", "fresh@example.com", null, null)], 1))));
		cut.Find(SearchBox).Input("jane");
		cut.Find(SearchBox).KeyDown(new KeyboardEventArgs { Key = "Enter" });
		cut.Find(SearchBox).Input("janet");
		cut.Find(SearchBox).KeyDown(new KeyboardEventArgs { Key = "Enter" });
		cut.WaitForAssertion(() => TextOf(cut).Should().Contain("Fresh Result"));

		// Act
		older.SetResult(Result.Ok(new UserPage([new UserSummary("auth0|old", "Stale Result", "stale@example.com", null, null)], 1)));

		// Assert
		cut.WaitForAssertion(() => TextOf(cut).Should().Contain("Fresh Result"));
		TextOf(cut).Should().NotContain("Stale Result");
	}

	[Fact]
	public void Search_NewText_GoesBackToPageOne()
	{
		// Arrange
		Open("?page=3");
		ReturnPage(People(25), 200);
		IRenderedComponent<UsersPage> cut = RenderPage();
		_api.ClearReceivedCalls();

		// Act
		cut.Find(SearchBox).Input("jane");
		cut.Find(SearchBox).KeyDown(new KeyboardEventArgs { Key = "Enter" });

		// Assert
		cut.WaitForAssertion(() => SearchesSent().Should().ContainSingle()
			.Which.Page.Should().Be(1));
	}

	[Fact]
	public void Next_Clicked_SearchesTheNextPageOfTheSameQuery()
	{
		// Arrange
		Open("?q=jane");
		ReturnPage(People(25), 60);
		IRenderedComponent<UsersPage> cut = RenderPage();
		_api.ClearReceivedCalls();

		// Act
		ButtonWithText(cut, "Next").Click();

		// Assert
		cut.WaitForAssertion(() => SearchesSent().Should().ContainSingle()
			.Which.Should().Be(new UserSearch(UserSearchQueryBuilder.Build("jane"), 2, 25)));
	}

	[Fact]
	public void Prev_Clicked_SearchesThePreviousPage()
	{
		// Arrange
		Open("?page=3");
		ReturnPage(People(10), 60);
		IRenderedComponent<UsersPage> cut = RenderPage();
		_api.ClearReceivedCalls();

		// Act
		ButtonWithText(cut, "Prev").Click();

		// Assert
		cut.WaitForAssertion(() => SearchesSent().Should().ContainSingle().Which.Page.Should().Be(2));
	}

	[Fact]
	public void Search_Finished_WritesQueryBackWithReplaceStateAndNeverNavigates()
	{
		// Arrange
		IRenderedComponent<UsersPage> cut = RenderPage();
		int historyBefore = Navigation.History.Count;
		string uriBefore = Navigation.Uri;

		// Act
		cut.Find(SearchBox).Input("jane");
		cut.Find(SearchBox).KeyDown(new KeyboardEventArgs { Key = "Enter" });

		// Assert
		cut.WaitForAssertion(() => WrittenQuery().GetValueOrDefault("q").ToString().Should().Be("jane"));
		WrittenUrl().AbsolutePath.Should().Be("/admin/users");
		Navigation.History.Count.Should().Be(historyBefore);
		Navigation.Uri.Should().Be(uriBefore);
	}

	[Fact]
	public void Next_Clicked_WritesThePageBackWithReplaceStateAndNeverNavigates()
	{
		// Arrange
		Open("?q=jane");
		ReturnPage(People(25), 60);
		IRenderedComponent<UsersPage> cut = RenderPage();
		int historyBefore = Navigation.History.Count;

		// Act
		ButtonWithText(cut, "Next").Click();

		// Assert
		cut.WaitForAssertion(() => WrittenQuery().GetValueOrDefault("page").ToString().Should().Be("2"));
		WrittenQuery().GetValueOrDefault("q").ToString().Should().Be("jane");
		Navigation.History.Count.Should().Be(historyBefore);
	}

	[Fact]
	public void Search_FromPageThree_WritesPageOneOrNoPageBack()
	{
		// Arrange
		Open("?page=3");
		ReturnPage(People(25), 200);
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Act
		cut.Find(SearchBox).Input("jane");
		cut.Find(SearchBox).KeyDown(new KeyboardEventArgs { Key = "Enter" });

		// Assert
		cut.WaitForAssertion(() => WrittenQuery().GetValueOrDefault("q").ToString().Should().Be("jane"));
		StringValues page = WrittenQuery().GetValueOrDefault("page");
		(StringValues.IsNullOrEmpty(page) || page == "1").Should().BeTrue();
	}

	[Fact]
	public void Row_Clicked_WritesTheUserIdBackWithReplaceStateAndNeverNavigates()
	{
		// Arrange
		UserSummary[] people = People(3);
		ReturnPage(people, 3);
		IRenderedComponent<UsersPage> cut = RenderPage();
		int historyBefore = Navigation.History.Count;

		// Act
		IElement row = Rows(cut)[1];
		(row.QuerySelector("button, a") ?? row).Click();

		// Assert
		cut.WaitForAssertion(() => WrittenQuery().GetValueOrDefault("user").ToString().Should().Be(people[1].Id));
		Navigation.History.Count.Should().Be(historyBefore);
	}

	[Fact]
	public void Next_ClickedWithAUserInTheUrl_KeepsTheUserInTheWrittenUrl()
	{
		// Arrange
		Open("?user=auth0%7Cuser-2");
		ReturnPage(People(25), 60);
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Act
		ButtonWithText(cut, "Next").Click();

		// Assert
		cut.WaitForAssertion(() => WrittenQuery().GetValueOrDefault("page").ToString().Should().Be("2"));
		WrittenQuery().GetValueOrDefault("user").ToString().Should().Be("auth0|user-2");
	}

	[Theory]
	[InlineData("User.SearchTooBroad", "That search took Auth0 too long. Narrow the search.", ResultErrorCode.Validation)]
	[InlineData("User.SearchInvalid", "Auth0 couldn't run that search. Change the search text and try again.", ResultErrorCode.Validation)]
	public void Search_AuthRefusesTheSearch_ShowsAnErrorAlertWithTheMessage(string code, string message, ResultErrorCode category)
	{
		// Arrange
		IRenderedComponent<UsersPage> cut = RenderPage();
		_api.SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Fail<UserPage>(message, category, code)));

		// Act
		cut.Find(SearchBox).Input("jane");
		cut.Find(SearchBox).KeyDown(new KeyboardEventArgs { Key = "Enter" });

		// Assert
		cut.WaitForAssertion(() => cut.Find("[role=alert]").TextContent.Should().Contain(message));
		cut.Find("[role=alert]").ClassList.Should().Contain("bg-red-50");
	}

	[Fact]
	public void Search_QueryOverOneHundredCharacters_ShowsAnErrorAlertAndSendsNoSearch()
	{
		// Arrange
		IRenderedComponent<UsersPage> cut = RenderPage();
		_api.ClearReceivedCalls();

		// Act
		cut.Find(SearchBox).Input(new string('a', 101));
		cut.Find(SearchBox).KeyDown(new KeyboardEventArgs { Key = "Enter" });

		// Assert
		cut.WaitForAssertion(() => cut.Find("[role=alert]").ClassList.Should().Contain("bg-red-50"));
		SearchesSent().Should().BeEmpty();
	}

	[Fact]
	public void Search_RateLimited_ShowsAWarningAlertAndKeepsTheSearchBoxAsTyped()
	{
		// Arrange
		const string message = "Auth0 is rate limiting the app. Try again in 3 seconds.";
		IRenderedComponent<UsersPage> cut = RenderPage();
		_api.SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>()).Returns(Task.FromResult(
			Result.Fail<UserPage>(message, ResultErrorCode.RateLimited, "ManagementApi.RateLimited")));

		// Act
		cut.Find(SearchBox).Input("Jane");
		cut.Find(SearchBox).KeyDown(new KeyboardEventArgs { Key = "Enter" });

		// Assert
		cut.WaitForAssertion(() => cut.Find("[role=alert]").TextContent.Should().Contain(message));
		cut.Find("[role=alert]").ClassList.Should().Contain("bg-amber-50");
		cut.Find(SearchBox).GetAttribute("value").Should().Be("Jane");
	}

	[Fact]
	public void Render_RateLimitedOnLoad_ShowsAWarningAlertAndTheQueryFromTheUrlInTheSearchBox()
	{
		// Arrange
		Open("?q=Jane");
		_api.SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>()).Returns(Task.FromResult(
			Result.Fail<UserPage>("Auth0 is rate limiting the app. Try again in a few seconds.", ResultErrorCode.RateLimited,
				"ManagementApi.RateLimited")));

		// Act
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Assert
		cut.Find("[role=alert]").ClassList.Should().Contain("bg-amber-50");
		cut.Find(SearchBox).GetAttribute("value").Should().Be("Jane");
	}

	[Fact]
	public void Render_ManagementApiThrows_ShowsTheErrorBoundaryMessage()
	{
		// Arrange
		_api.SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>())
			.Returns<Task<Result<UserPage>>>(_ => throw new InvalidOperationException("Management API unreachable"));

		// Act
		IRenderedComponent<UsersPage> cut = RenderPage();

		// Assert
		cut.WaitForAssertion(() => cut.Markup.Should().Contain(ManagementApiMessage));
	}

	[Fact]
	public void TryAgain_ClickedAfterTheManagementApiRecovers_ShowsTheUsersAgain()
	{
		// Arrange
		_api.SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>())
			.Returns<Task<Result<UserPage>>>(_ => throw new InvalidOperationException("Management API unreachable"));
		IRenderedComponent<UsersPage> cut = RenderPage();
		cut.WaitForAssertion(() => cut.Markup.Should().Contain(ManagementApiMessage));
		ReturnPage(People(3), 3);

		// Act
		ButtonWithText(cut, "Try again").Click();

		// Assert
		cut.WaitForAssertion(() => Rows(cut).Should().HaveCount(3));
		cut.Markup.Should().NotContain(ManagementApiMessage);
	}

	private void Open(string query) => Navigation.NavigateTo($"http://localhost/admin/users{query}");

	private IRenderedComponent<UsersPage> RenderPage() => Render<UsersPage>();

	private void ReturnPage(IReadOnlyList<UserSummary> users, int total) =>
		_api.SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>())
			.Returns(Task.FromResult(Result.Ok(new UserPage(users, total))));

	private static UserSummary[] People(int count) =>
	[
		.. Enumerable.Range(1, count).Select(index => new UserSummary($"auth0|user-{index}", $"Person {index}", $"person{index}@example.com", null, null)),
	];

	private static IReadOnlyList<IElement> Rows(IRenderedComponent<UsersPage> cut) => [.. cut.FindAll("ul > li")];

	private static IElement ButtonWithText(IRenderedComponent<UsersPage> cut, string text) =>
		cut.FindAll("button").Single(button => button.TextContent.Contains(text, StringComparison.Ordinal));

	private static string TextOf(IRenderedComponent<UsersPage> cut) =>
		Regex.Replace(string.Concat(cut.Nodes.Select(node => node.TextContent)), @"\s+", " ").Trim();

	private List<UserSearch> SearchesSent() =>
	[
		.. _api.ReceivedCalls()
			.Where(call => call.GetMethodInfo().Name == nameof(IManagementApi.SearchUsersAsync))
			.Select(call => (UserSearch)call.GetArguments()[0]!),
	];

	private Uri WrittenUrl()
	{
		string url = (string)_module.Invocations["replaceUrl"][^1].Arguments[0]!;

		return new Uri(new Uri("http://localhost/"), url);
	}

	private Dictionary<string, StringValues> WrittenQuery() => QueryHelpers.ParseQuery(WrittenUrl().Query);
}
