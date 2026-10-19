// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     UpdateProfileFieldsTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using System.Text.Json;

using Domain.Abstractions;

using UI.ManagementApi;

namespace UI.Tests.Unit.ManagementApi;

public class UpdateProfileFieldsTests
{
	private static ManagementApiHarness HarnessThatAccepts()
	{
		ManagementApiHarness harness = ManagementApiHarness.Create();
		harness.Handler.Respond(_ => Auth0Responses.Json(Auth0Responses.User()));

		return harness;
	}

	private static async Task<(Result Result, JsonElement Body)> UpdateAsync(ProfileFieldsChange change)
	{
		using ManagementApiHarness harness = HarnessThatAccepts();

		Result result = await harness.Api.UpdateProfileFieldsAsync(ApiCalls.UserId, change, Xunit.TestContext.Current.CancellationToken);

		RecordedRequest request = harness.Handler.ManagementRequests.Should().ContainSingle().Subject;
		request.Method.Should().Be(HttpMethod.Patch);
		request.Path.Should().Be("/api/v2/users/auth0|abc");

		return (result, JsonDocument.Parse(request.Body).RootElement.Clone());
	}

	private static string[] PropertyNames(JsonElement body)
	{
		return [.. body.EnumerateObject().Select(property => property.Name)];
	}

	public static TheoryData<string, string> FieldToWireName => new()
	{
		{ nameof(ProfileFieldsChange.Name), "name" },
		{ nameof(ProfileFieldsChange.GivenName), "given_name" },
		{ nameof(ProfileFieldsChange.FamilyName), "family_name" },
		{ nameof(ProfileFieldsChange.Nickname), "nickname" },
		{ nameof(ProfileFieldsChange.Picture), "picture" },
	};

	private static ProfileFieldsChange ChangeOf(string field, string value)
	{
		return field switch
		{
			nameof(ProfileFieldsChange.Name) => new ProfileFieldsChange(Name: value),
			nameof(ProfileFieldsChange.GivenName) => new ProfileFieldsChange(GivenName: value),
			nameof(ProfileFieldsChange.FamilyName) => new ProfileFieldsChange(FamilyName: value),
			nameof(ProfileFieldsChange.Nickname) => new ProfileFieldsChange(Nickname: value),
			nameof(ProfileFieldsChange.Picture) => new ProfileFieldsChange(Picture: value),
			_ => throw new ArgumentOutOfRangeException(nameof(field), field, "Unknown field."),
		};
	}

	[Theory]
	[MemberData(nameof(FieldToWireName))]
	public async Task UpdateProfileFieldsAsync_OneFieldChanged_SendsOnlyThatField(string field, string wireName)
	{
		// Arrange
		ProfileFieldsChange change = ChangeOf(field, "https://example.test/new-value");

		// Act
		(Result result, JsonElement body) = await UpdateAsync(change);

		// Assert
		result.Success.Should().BeTrue();
		PropertyNames(body).Should().Equal(wireName);
		body.GetProperty(wireName).GetString().Should().Be("https://example.test/new-value");
	}

	[Fact]
	public async Task UpdateProfileFieldsAsync_NullProperties_AreLeftOutOfTheRequestBody()
	{
		// Arrange
		ProfileFieldsChange change = new(Nickname: "jd", Picture: null);

		// Act
		(Result result, JsonElement body) = await UpdateAsync(change);

		// Assert
		result.Success.Should().BeTrue();
		PropertyNames(body).Should().Equal("nickname");
	}

	[Theory]
	[MemberData(nameof(FieldToWireName))]
	public async Task UpdateProfileFieldsAsync_EmptyString_SendsAnExplicitNullToClearTheField(string field, string wireName)
	{
		// Arrange
		ProfileFieldsChange change = ChangeOf(field, string.Empty);

		// Act
		(Result result, JsonElement body) = await UpdateAsync(change);

		// Assert
		result.Success.Should().BeTrue();
		PropertyNames(body).Should().Equal(wireName);
		body.GetProperty(wireName).ValueKind.Should().Be(JsonValueKind.Null);
	}

	[Fact]
	public async Task UpdateProfileFieldsAsync_EmptyEmail_ThrowsWithoutCallingAuth0()
	{
		// Arrange
		using ManagementApiHarness harness = HarnessThatAccepts();

		// Act
		Func<Task> act = () => harness.Api.UpdateProfileFieldsAsync(
			ApiCalls.UserId, new ProfileFieldsChange(Email: string.Empty), Xunit.TestContext.Current.CancellationToken);

		// Assert
		await act.Should().ThrowAsync<ArgumentException>();
		harness.Handler.ManagementRequests.Should().BeEmpty();
	}

	[Fact]
	public async Task UpdateProfileFieldsAsync_NoFieldSet_ThrowsWithoutCallingAuth0()
	{
		// Arrange
		using ManagementApiHarness harness = HarnessThatAccepts();

		// Act
		Func<Task> act = () => harness.Api.UpdateProfileFieldsAsync(
			ApiCalls.UserId, new ProfileFieldsChange(), Xunit.TestContext.Current.CancellationToken);

		// Assert
		await act.Should().ThrowAsync<ArgumentException>();
		harness.Handler.ManagementRequests.Should().BeEmpty();
	}

	[Fact]
	public async Task UpdateProfileFieldsAsync_EmailChange_SendsEmailUnverifiedWithoutAVerificationEmail()
	{
		// Arrange
		ProfileFieldsChange change = new(Email: "new@example.test");

		// Act
		(Result result, JsonElement body) = await UpdateAsync(change);

		// Assert
		result.Success.Should().BeTrue();
		PropertyNames(body).Should().BeEquivalentTo("email", "email_verified", "verify_email");
		body.GetProperty("email").GetString().Should().Be("new@example.test");
		body.GetProperty("email_verified").ValueKind.Should().Be(JsonValueKind.False);
		body.GetProperty("verify_email").ValueKind.Should().Be(JsonValueKind.False);
	}

	[Fact]
	public async Task UpdateProfileFieldsAsync_NoEmailChange_NeverSendsEmailVerifiedOrVerifyEmail()
	{
		// Arrange
		ProfileFieldsChange change = new(Name: "Jane Q. Doe", Nickname: "jq");

		// Act
		(Result result, JsonElement body) = await UpdateAsync(change);

		// Assert
		result.Success.Should().BeTrue();
		PropertyNames(body).Should().BeEquivalentTo("name", "nickname");
	}
}
