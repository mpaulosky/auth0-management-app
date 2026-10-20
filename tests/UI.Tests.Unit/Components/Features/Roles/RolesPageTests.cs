// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     RolesPageTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using System.Text.RegularExpressions;

using AngleSharp.Dom;

using Bunit.TestDoubles;

using Domain.Abstractions;

using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;

using UI.Components.Features.Roles;
using UI.ManagementApi;

using static UI.Tests.Unit.Components.Features.Roles.RolesTestData;

namespace UI.Tests.Unit.Components.Features.Roles;

/// <summary>
///   The Roles page with the real handler and a substituted <see cref="IManagementApi" />. It relies on this markup:
///   each Role tile is a <c>button</c> with <c>aria-pressed</c>; the User table's Role columns are <c>th</c> and
///   <c>td</c> cells carrying <c>data-role="{Role id}"</c>, a check shown as "✓" and an unknown as "?"; and the
///   Users | Roles tab switch is two anchors, the current one with <c>aria-current="page"</c>.
/// </summary>
public class RolesPageTests : BunitContext
{
	private const string Check = "✓";

	private const string UnknownTitle = "Unknown: more than 1,000 Users hold this Role";

	private const string ErrorBoundaryMessage =
		"The app couldn't reach Auth0's Management API. Try again, or ask whoever runs the app to check its Auth0 Management settings.";

	private const string ModulePath = "./Components/Features/Roles/RolesContent.razor.js";

	private readonly IManagementApi _api = Tenant();
	private readonly BunitJSModuleInterop _module;

	public RolesPageTests()
	{
		// Registrations first: bUnit refuses new ones once the JS interop or renderer info has initialized its container.
		Services.AddSingleton(_api);
		Services.AddRolesFeature();
		AddAuthorization().SetAuthorized("an-admin");
		JSInterop.Mode = JSRuntimeMode.Loose;
		_module = JSInterop.SetupModule(ModulePath);
		_module.Mode = JSRuntimeMode.Loose;
		SetRendererInfo(new RendererInfo("Server", true));
	}

	[Fact]
	public void Render_Tenant_ShowsATilePerRoleWithItsNameAndDescription()
	{
		// Arrange

		// Act
		IRenderedComponent<RolesPage> cut = RenderPage();

		// Assert
		IElement[] tiles = [.. cut.FindAll("button[aria-pressed]")];
		tiles.Should().HaveCount(3);
		tiles[0].TextContent.Should().Contain("Admin").And.Contain("Manages the Tenant");
		tiles[1].TextContent.Should().Contain("Editor").And.Contain("Edits the content");
		tiles[2].TextContent.Should().Contain("Viewer");
	}

	[Fact]
	public void Render_RolesHeldByDifferentNumbersOfUsers_EachTileShowsItsCount()
	{
		// Arrange
		_api.ListRoleMembersAsync(AdminRole.Id, Arg.Any<CancellationToken>()).Returns(MembersOfCount(2));
		_api.ListRoleMembersAsync(EditorRole.Id, Arg.Any<CancellationToken>()).Returns(MembersOfCount(17));

		// Act
		IRenderedComponent<RolesPage> cut = RenderPage();

		// Assert
		IElement[] tiles = [.. cut.FindAll("button[aria-pressed]")];
		ShowsCount(tiles[0], "2").Should().BeTrue("the Admin tile counts its 2 Users");
		ShowsCount(tiles[1], "17").Should().BeTrue("the Editor tile counts its 17 Users");
		ShowsCount(tiles[2], "0").Should().BeTrue("the Viewer tile counts no Users");
	}

	[Fact]
	public void Render_TruncatedRole_TileShowsOneThousandPlusInPlaceOfACount()
	{
		// Arrange
		_api.ListRoleMembersAsync(EditorRole.Id, Arg.Any<CancellationToken>()).Returns(TruncatedMembers(Jane, Bob));

		// Act
		IRenderedComponent<RolesPage> cut = RenderPage();

		// Assert
		IElement[] tiles = [.. cut.FindAll("button[aria-pressed]")];
		tiles[1].TextContent.Should().Contain("1,000+");
		tiles[0].TextContent.Should().NotContain("1,000+");
	}

	[Fact]
	public void Render_NoRolePicked_ListsTheFirstPageOfUsersFromTheSearch()
	{
		// Arrange

		// Act
		IRenderedComponent<RolesPage> cut = RenderPage();

		// Assert
		IElement[] rows = [.. cut.FindAll("tbody tr")];
		rows.Should().HaveCount(3);
		rows[0].TextContent.Should().Contain("Jane Doe").And.Contain("jane@example.com");
		rows[1].TextContent.Should().Contain("Bob Roe");
		rows[2].TextContent.Should().Contain("Cy Poe");
		cut.FindAll("button[aria-pressed='true']").Should().BeEmpty();
		_api.Received(1).SearchUsersAsync(Arg.Is<UserSearch>(search => search.Query == null && search.Page == 1),
			Arg.Any<CancellationToken>());
	}

	[Fact]
	public void Render_Tenant_TableHasAColumnPerRoleInTileOrder()
	{
		// Arrange

		// Act
		IRenderedComponent<RolesPage> cut = RenderPage();

		// Assert
		IElement[] headers = [.. cut.FindAll("th[data-role]")];
		headers.Select(header => header.GetAttribute("data-role")).Should().Equal(AdminRole.Id, EditorRole.Id, ViewerRole.Id);
		headers.Select(header => header.TextContent.Trim()).Should().Equal("Admin", "Editor", "Viewer");
	}

	[Fact]
	public void Render_Tenant_ACheckMarksEachRoleTheUserHolds()
	{
		// Arrange

		// Act
		IRenderedComponent<RolesPage> cut = RenderPage();

		// Assert
		IElement jane = RowOf(cut, "Jane Doe");
		CellText(jane, AdminRole).Should().Be(Check);
		CellText(jane, EditorRole).Should().Be(Check);
		CellText(jane, ViewerRole).Should().BeEmpty();
		IElement bob = RowOf(cut, "Bob Roe");
		CellText(bob, AdminRole).Should().BeEmpty();
		CellText(bob, EditorRole).Should().Be(Check);
		IElement cy = RowOf(cut, "Cy Poe");
		cy.QuerySelectorAll("td[data-role]").Select(cell => cell.TextContent.Trim()).Should().OnlyContain(text => text.Length == 0);
	}

	[Fact]
	public void Render_TruncatedRole_UserOutsideTheFetchedMembersShowsAQuestionMarkTitledUnknown()
	{
		// Arrange
		_api.ListRoleMembersAsync(EditorRole.Id, Arg.Any<CancellationToken>()).Returns(TruncatedMembers(Jane));

		// Act
		IRenderedComponent<RolesPage> cut = RenderPage();

		// Assert
		IElement bob = RowOf(cut, "Bob Roe");
		CellText(bob, EditorRole).Should().Be("?");
		bob.QuerySelector($"td[data-role='{EditorRole.Id}'] [title='{UnknownTitle}'], td[data-role='{EditorRole.Id}'][title='{UnknownTitle}']")
			.Should().NotBeNull("the question mark is titled 'Unknown: more than 1,000 Users hold this Role'");
		CellText(bob, AdminRole).Should().BeEmpty("the Admin Role isn't truncated, so Bob certainly doesn't hold it");
	}

	[Fact]
	public void Render_TruncatedRole_UserAmongTheFetchedMembersStillShowsACheck()
	{
		// Arrange
		_api.ListRoleMembersAsync(EditorRole.Id, Arg.Any<CancellationToken>()).Returns(TruncatedMembers(Jane));

		// Act
		IRenderedComponent<RolesPage> cut = RenderPage();

		// Assert
		CellText(RowOf(cut, "Jane Doe"), EditorRole).Should().Be(Check);
	}

	[Fact]
	public void Render_TruncatedRoleNotPicked_ShowsNoFirstThousandNote()
	{
		// Arrange
		_api.ListRoleMembersAsync(EditorRole.Id, Arg.Any<CancellationToken>()).Returns(TruncatedMembers(Jane));

		// Act
		IRenderedComponent<RolesPage> cut = RenderPage();

		// Assert
		cut.Markup.Should().NotContain("Showing the first 1,000 Users");
	}

	[Fact]
	public void Click_Tile_FiltersTheTableToThatRolesMembers()
	{
		// Arrange
		IRenderedComponent<RolesPage> cut = RenderPage();

		// Act
		TileOf(cut, "Admin").Click();

		// Assert
		cut.WaitForAssertion(() =>
		{
			cut.FindAll("tbody tr").Select(row => row.TextContent).Should().ContainSingle().Which.Should().Contain("Jane Doe");
			TileOf(cut, "Admin").GetAttribute("aria-pressed").Should().Be("true");
			TileOf(cut, "Editor").GetAttribute("aria-pressed").Should().Be("false");
		});
	}

	[Fact]
	public void Click_PickedTile_ClearsTheFilterAndListsTheFirstPageAgain()
	{
		// Arrange
		IRenderedComponent<RolesPage> cut = RenderPage($"?role={AdminRole.Id}");

		// Act
		TileOf(cut, "Admin").Click();

		// Assert
		cut.WaitForAssertion(() =>
		{
			cut.FindAll("tbody tr").Should().HaveCount(3);
			cut.FindAll("button[aria-pressed='true']").Should().BeEmpty();
		});
	}

	[Fact]
	public void Click_Tile_SetsRoleInTheUrlWithoutNavigating()
	{
		// Arrange
		IRenderedComponent<RolesPage> cut = RenderPage();
		NavigationManager navigation = Services.GetRequiredService<NavigationManager>();
		string uriBefore = navigation.Uri;
		int historyBefore = HistoryCount();

		// Act
		TileOf(cut, "Editor").Click();

		// Assert
		cut.WaitForAssertion(() => _module.Invocations
			.Where(invocation => invocation.Identifier == "replaceUrl"
				&& invocation.Arguments.Any(argument => argument?.ToString()?.Contains($"role={EditorRole.Id}", StringComparison.Ordinal) == true))
			.Should().NotBeEmpty("the page writes role=<id> into the URL through the module, which keeps the history state"));
		navigation.Uri.Should().Be(uriBefore, "the tile doesn't navigate: that would be an enhanced navigation, a server round trip");
		HistoryCount().Should().Be(historyBefore);
	}

	[Fact]
	public void Click_Tile_FiltersWithoutCallingTheManagementApiAgain()
	{
		// Arrange
		IRenderedComponent<RolesPage> cut = RenderPage();
		_api.ClearReceivedCalls();

		// Act
		TileOf(cut, "Editor").Click();
		cut.WaitForAssertion(() => TileOf(cut, "Editor").GetAttribute("aria-pressed").Should().Be("true"));
		TileOf(cut, "Editor").Click();

		// Assert
		cut.WaitForAssertion(() => cut.FindAll("tbody tr").Should().HaveCount(3));
		_api.ReceivedCalls().Should().BeEmpty("the loaded members and first page answer both the pick and the clear");
	}

	[Fact]
	public void Click_PickedTileAfterOpeningTheUrlWithRole_ListsTheFirstPageFromTheSearch()
	{
		// Arrange
		IRenderedComponent<RolesPage> cut = RenderPage($"?role={EditorRole.Id}");

		// Act
		TileOf(cut, "Editor").Click();

		// Assert
		cut.WaitForAssertion(() => cut.FindAll("tbody tr").Should().HaveCount(3));
		_api.Received(1).SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>());
	}

	[Fact]
	public void Click_TileWhileAnEarlierLoadIsStillRunning_TheEarlierLoadDoesNotOverwriteIt()
	{
		// Arrange
		IRenderedComponent<RolesPage> cut = RenderPage($"?role={EditorRole.Id}");
		TaskCompletionSource<Result<UserPage>> search = new();
		_api.SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>()).Returns(search.Task);
		TileOf(cut, "Editor").Click();

		// Act
		TileOf(cut, "Admin").Click();
		cut.WaitForAssertion(() => TileOf(cut, "Admin").GetAttribute("aria-pressed").Should().Be("true"));
		search.SetResult(Page(Jane, Bob, Cy));

		// Assert
		cut.WaitForAssertion(() =>
		{
			TileOf(cut, "Admin").GetAttribute("aria-pressed").Should().Be("true");
			cut.FindAll("tbody tr").Should().ContainSingle();
		});
	}

	[Fact]
	public void Click_RolesTabAfterPickingATile_ClearsThePick()
	{
		// Arrange
		IRenderedComponent<RolesPage> cut = RenderPage();
		TileOf(cut, "Editor").Click();
		cut.WaitForAssertion(() => cut.FindAll("tbody tr").Should().HaveCount(2));

		// Act
		Services.GetRequiredService<NavigationManager>().NavigateTo("/admin/roles");

		// Assert
		cut.WaitForAssertion(() =>
		{
			cut.FindAll("button[aria-pressed='true']").Should().BeEmpty();
			cut.FindAll("tbody tr").Should().HaveCount(3);
		});
	}

	[Fact]
	public void Click_ShowAllRolesAfterAPickedRoleFailsToLoad_BringsTheTableBack()
	{
		// Arrange
		_api.ListRoleMembersAsync("rol_gone", Arg.Any<CancellationToken>()).Returns(RoleNotFound<RoleMembers>());
		IRenderedComponent<RolesPage> cut = RenderPage("?role=rol_gone");

		// Act
		cut.Find("button:not([aria-pressed])").Click();

		// Assert
		cut.WaitForAssertion(() =>
		{
			cut.FindAll("table").Should().ContainSingle();
			cut.FindAll("[role='alert']").Should().BeEmpty();
			cut.FindAll("tbody tr").Should().HaveCount(3);
		});
	}

	[Fact]
	public void Click_TryAgainAfterTheFirstLoadIsRateLimited_LoadsTheRolesOnceTheLimitLifts()
	{
		// Arrange
		_api.ListRolesAsync(Arg.Any<CancellationToken>()).Returns(RateLimited<IReadOnlyList<RoleSummary>>());
		IRenderedComponent<RolesPage> cut = RenderPage();
		_api.ListRolesAsync(Arg.Any<CancellationToken>()).Returns(RolesTestData.Roles(AdminRole, EditorRole, ViewerRole));

		// Act
		cut.Find("button:not([aria-pressed])").Click();

		// Assert
		cut.WaitForAssertion(() =>
		{
			cut.FindAll("table").Should().ContainSingle();
			cut.FindAll("[role='alert']").Should().BeEmpty();
		});
	}

	[Fact]
	public void Click_TryAgainAfterAPickedRoleIsRateLimited_ReloadsThatRole()
	{
		// Arrange
		_api.ListRoleMembersAsync(EditorRole.Id, Arg.Any<CancellationToken>()).Returns(RateLimited<RoleMembers>());
		IRenderedComponent<RolesPage> cut = RenderPage($"?role={EditorRole.Id}");
		_api.ListRoleMembersAsync(EditorRole.Id, Arg.Any<CancellationToken>()).Returns(Members(Jane, Bob));
		IElement recover = cut.Find("button:not([aria-pressed])");
		recover.TextContent.Trim().Should().Be("Try again", "a rate limit can lift, so the Admin can retry the Role they asked for");

		// Act
		recover.Click();

		// Assert
		cut.WaitForAssertion(() =>
		{
			cut.FindAll("tbody tr").Should().HaveCount(2);
			TileOf(cut, "Editor").GetAttribute("aria-pressed").Should().Be("true");
		});
		_api.DidNotReceive().SearchUsersAsync(Arg.Any<UserSearch>(), Arg.Any<CancellationToken>());
	}

	[Fact]
	public void Click_LinkToAnotherPageAfterPickingATile_DoesNotReloadTheRoles()
	{
		// Arrange
		IRenderedComponent<RolesPage> cut = RenderPage();
		TileOf(cut, "Editor").Click();
		cut.WaitForAssertion(() => cut.FindAll("tbody tr").Should().HaveCount(2));
		_api.ClearReceivedCalls();

		// Act
		Services.GetRequiredService<NavigationManager>().NavigateTo("/admin/users");

		// Assert
		_api.ReceivedCalls().Should().BeEmpty("the page is about to go, so a reload would only spend the Users page's rate limit");
		TileOf(cut, "Editor").GetAttribute("aria-pressed").Should().Be("true");
	}

	[Fact]
	public void Render_RoleInTheUrl_ShowsTheTableFilteredToThatRole()
	{
		// Arrange

		// Act
		IRenderedComponent<RolesPage> cut = RenderPage($"?role={EditorRole.Id}");

		// Assert
		cut.FindAll("tbody tr").Select(row => row.TextContent).Should().HaveCount(2)
			.And.Contain(text => text.Contains("Jane Doe", StringComparison.Ordinal))
			.And.Contain(text => text.Contains("Bob Roe", StringComparison.Ordinal));
		TileOf(cut, "Editor").GetAttribute("aria-pressed").Should().Be("true");
		TileOf(cut, "Admin").GetAttribute("aria-pressed").Should().Be("false");
	}

	[Fact]
	public void Render_TruncatedRoleInTheUrl_ShowsTheFirstThousandNoteWithTheRoleName()
	{
		// Arrange
		_api.ListRoleMembersAsync(EditorRole.Id, Arg.Any<CancellationToken>()).Returns(TruncatedMembers(Jane, Bob));

		// Act
		IRenderedComponent<RolesPage> cut = RenderPage($"?role={EditorRole.Id}");

		// Assert
		cut.Markup.Should().Contain("Showing the first 1,000 Users who hold Editor.");
	}

	[Fact]
	public void Render_RoleInTheUrlThatIsNotTruncated_ShowsNoFirstThousandNote()
	{
		// Arrange

		// Act
		IRenderedComponent<RolesPage> cut = RenderPage($"?role={EditorRole.Id}");

		// Assert
		cut.Markup.Should().NotContain("Showing the first 1,000 Users");
	}

	[Fact]
	public void Click_TruncatedRoleTile_ShowsTheFirstThousandNote()
	{
		// Arrange
		_api.ListRoleMembersAsync(EditorRole.Id, Arg.Any<CancellationToken>()).Returns(TruncatedMembers(Jane, Bob));
		IRenderedComponent<RolesPage> cut = RenderPage();

		// Act
		TileOf(cut, "Editor").Click();

		// Assert
		cut.WaitForAssertion(() => cut.Markup.Should().Contain("Showing the first 1,000 Users who hold Editor."));
	}

	[Fact]
	public void Render_Rows_EachLinksToThatUserOnTheUsersPage()
	{
		// Arrange

		// Act
		IRenderedComponent<RolesPage> cut = RenderPage();

		// Assert
		foreach (UserSummary user in new[] { Jane, Bob, Cy })
		{
			IElement link = RowOf(cut, user.Name!).QuerySelectorAll("a").Should().ContainSingle().Subject;
			Uri target = Resolve(link.GetAttribute("href"));
			target.AbsolutePath.Should().Be("/admin/users");
			QueryHelpers.ParseQuery(target.Query)["user"].ToString().Should().Be(user.Id);
		}
	}

	[Fact]
	public void Render_RoleNotFound_ShowsTheNoLongerExistsMessageInPlaceOfTheTable()
	{
		// Arrange
		_api.ListRoleMembersAsync("rol_gone", Arg.Any<CancellationToken>()).Returns(RoleNotFound<RoleMembers>());

		// Act
		IRenderedComponent<RolesPage> cut = RenderPage("?role=rol_gone");

		// Assert
		cut.Markup.Should().Contain("This Role no longer exists in the Tenant.");
		cut.FindAll("table").Should().BeEmpty();
	}

	[Fact]
	public void Render_ManagementApiRateLimited_ShowsTheWarningAlertWithTheMessage()
	{
		// Arrange
		_api.ListRolesAsync(Arg.Any<CancellationToken>()).Returns(RateLimited<IReadOnlyList<RoleSummary>>());

		// Act
		IRenderedComponent<RolesPage> cut = RenderPage();

		// Assert
		IElement alert = cut.Find("[role='alert']");
		alert.TextContent.Should().Contain(RateLimitedMessage);
		alert.GetAttribute("class").Should().Contain("amber").And.NotContain("red");
		cut.FindAll("table").Should().BeEmpty();
	}

	[Fact]
	public void Render_ManagementApiThrows_ShowsTheManagementApiErrorBoundaryMessage()
	{
		// Arrange
		_api.ListRolesAsync(Arg.Any<CancellationToken>())
			.Returns<Task<Result<IReadOnlyList<RoleSummary>>>>(_ => throw new InvalidOperationException("Auth0 unreachable"));

		// Act
		IRenderedComponent<RolesPage> cut = RenderPage();

		// Assert
		cut.Markup.Should().Contain(ErrorBoundaryMessage);
		cut.FindAll("table").Should().BeEmpty();
	}

	[Fact]
	public void Render_Page_TabSwitchLinksToTheUsersAndRolesPages()
	{
		// Arrange

		// Act
		IRenderedComponent<RolesPage> cut = RenderPage();

		// Assert
		IElement users = TabOf(cut, "Users");
		IElement roles = TabOf(cut, "Roles");
		Resolve(users.GetAttribute("href")).PathAndQuery.Should().Be("/admin/users");
		Resolve(roles.GetAttribute("href")).PathAndQuery.Should().Be("/admin/roles");
		roles.GetAttribute("aria-current").Should().Be("page");
		users.HasAttribute("aria-current").Should().BeFalse();
	}

	[Fact]
	public void Render_Page_TabSwitchIsAnOrdinaryNavigationNotAClickHandler()
	{
		// Arrange

		// Act
		IRenderedComponent<RolesPage> cut = RenderPage();

		// Assert
		foreach (string tab in new[] { "Users", "Roles" })
		{
			IElement link = TabOf(cut, tab);
			link.TagName.Should().Be("A");
			link.Attributes.Select(attribute => attribute.Name).Should().NotContain(name => name.StartsWith("blazor:", StringComparison.Ordinal),
				"a tab is a plain link, not an @onclick that calls NavigateTo");
		}
	}

	private IRenderedComponent<RolesPage> RenderPage(string query = "")
	{
		Services.GetRequiredService<NavigationManager>().NavigateTo($"/admin/roles{query}");
		IRenderedComponent<RolesPage> cut = Render<RolesPage>();
		cut.WaitForState(() => cut.FindAll("table, [role='alert']").Count > 0 || cut.Markup.Contains(RoleNotFoundMessage, StringComparison.Ordinal));

		return cut;
	}

	private int HistoryCount() => Services.GetRequiredService<BunitNavigationManager>().History.Count;

	private static bool ShowsCount(IElement tile, string count) =>
		Regex.IsMatch(tile.TextContent, $@"(?<![\d,]){count}(?![\d,])");

	private static IElement TileOf(IRenderedComponent<RolesPage> cut, string roleName) =>
		cut.FindAll("button[aria-pressed]").Single(tile => tile.TextContent.Contains(roleName, StringComparison.Ordinal));

	private static IElement RowOf(IRenderedComponent<RolesPage> cut, string userName) =>
		cut.FindAll("tbody tr").Single(row => row.TextContent.Contains(userName, StringComparison.Ordinal));

	private static string CellText(IElement row, RoleSummary role) =>
		row.QuerySelector($"td[data-role='{role.Id}']")!.TextContent.Trim();

	private static IElement TabOf(IRenderedComponent<RolesPage> cut, string name) =>
		cut.FindAll("a").Single(link => link.TextContent.Trim() == name);

	private Uri Resolve(string? href) =>
		new(new Uri(Services.GetRequiredService<NavigationManager>().BaseUri), href);
}
