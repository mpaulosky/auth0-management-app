// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     ResultErrorCodeTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  Domain.Tests.Unit
// =============================================

using Domain.Abstractions;

namespace Domain.Tests.Unit.Abstractions;

public class ResultErrorCodeTests
{
	[Fact]
	public void RateLimited_IsDefinedAsSix()
	{
		// Arrange
		const int expectedValue = 6;

		// Act
		string? name = Enum.GetName(typeof(ResultErrorCode), expectedValue);

		// Assert
		name.Should().Be("RateLimited", "the Management API seam reports a 429 as ResultErrorCode.RateLimited = 6");
	}

	[Fact]
	public void RateLimited_FailWithRateLimitedCode_CarriesTheCodeAndDetails()
	{
		// Arrange
		ResultErrorCode code = Enum.Parse<ResultErrorCode>("RateLimited");

		// Act
		Result result = Result.Fail("Slow down.", code, "ManagementApi.RateLimited");

		// Assert
		result.ErrorCode.Should().Be(code);
		((int)result.ErrorCode).Should().Be(6);
		result.Details.Should().Be("ManagementApi.RateLimited");
	}
}
